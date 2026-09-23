/**
 * AIE bank-statement AI-fallback adapter — versioned whole-document facts
 * contract.
 *
 * WHAT THE MODEL IS ASKED FOR, AND WHY IT IS SO LITTLE. Exactly the facts a
 * human reads off the page: the statement's period and declared balances, and
 * for each transaction line its date, its printed description, its amount as
 * a POSITIVE magnitude, its direction, and the running balance if one is
 * printed. That is all.
 *
 * Everything else a `fdh_transactions` row needs — the cleaned description,
 * the transaction type hint, the source row hash, the economic fingerprint,
 * the duplicate decision, the balance rollforward, the certification
 * decision — is DERIVED by the existing, already-certified deterministic
 * code (`normalizeDescription`, `inferTypeHint`, `computeSourceRowHash`,
 * `computeEconomicFingerprint`, `decideDedup`, `reconcileBalances`,
 * `decideCertification`) from those raw readings. The AI is used as an OCR
 * substitute for a layout the deterministic parser could not segment, not as
 * a second implementation of the pipeline. This is the single most important
 * property of this adapter: an AI-fallback-produced statement is subjected to
 * the identical dedupe and reconciliation arithmetic as a natively-parsed
 * one, so it cannot bypass the checks that make a native import trustworthy.
 *
 * WHAT IS DELIBERATELY ABSENT. No `currencyCode` and no account identity —
 * jurisdiction and account are caller context, established before the AI was
 * ever asked, and are never AI-derived anywhere in this codebase. No
 * `transactionTypeHint`: it is a pure function of the description and
 * direction, so asking the model for it would spend tokens to obtain a worse
 * answer than `inferTypeHint` already gives, and would let a model's guess
 * enter a field downstream classification trusts. No confidence field
 * anywhere (P4/REC-04).
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import { aieDateField, aieMoneyField, aieTextField, aieMissingReasonSchema, aieLineItemMoney, aieLineItemDate } from '../shared/factsFields';

export const AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME = 'aie_bank_statement_document_facts';
export const AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION = '1';

/**
 * Hard cap on transaction rows in one extraction.
 *
 * Sized against the line-item output budget (see
 * `getAieAiMaxOutputTokensPerLineItemDocument()`), not chosen aesthetically:
 * ~4096 output tokens admits roughly this many rows in this shape. The native
 * pipeline's own ceiling is `PDF_MAX_TRANSACTION_ROWS = 5000`, which is a
 * resource limit on a deterministic parse and has no bearing on what a model
 * can emit in one response.
 *
 * A statement with MORE rows than this does not fail silently. The model is
 * asked to state explicitly whether it listed every row
 * (`allTransactionsListed`), and — far more reliably, because it does not
 * depend on the model being honest or correct — the rows are re-run through
 * the same balance rollforward the native parser uses, where a missing row
 * makes the closing balance disagree and marks the import `review_required`
 * instead of certified.
 */
export const AIE_BANK_STATEMENT_MAX_TRANSACTIONS = 80;

export const BANK_STATEMENT_CREDIT_DEBIT = ['credit', 'debit'] as const;

/** One transaction line as PRINTED. Deliberately flat and small: a per-field
 * `missingReasonCode` envelope on every row would multiply the token cost of
 * the whole document for no benefit, because a row the model could not read
 * should simply be omitted — and its omission is then caught by the balance
 * rollforward, which is a real check rather than a self-report. */
export const bankStatementTransactionSchema = z
  .object({
    transactionDate: aieLineItemDate,
    /** The description EXACTLY as printed. Cleaning is `normalizeDescription`'s
     * job, on the native path and this one alike. */
    descriptionRaw: z.string().min(1).max(500),
    /** POSITIVE MAGNITUDE ONLY. Direction lives in `creditDebit`. A signed
     * amount here would be a second, contradictory encoding of direction —
     * exactly what `AcceptedPdfTransactionPlan`'s own contract forbids. */
    amount: aieLineItemMoney,
    creditDebit: z.enum(BANK_STATEMENT_CREDIT_DEBIT),
    /** The running balance printed AFTER this transaction, or null when the
     * statement layout does not print one. Null is not a failure: it only
     * means the rollforward has less to check against, and
     * `reconcileBalances` already handles its absence. */
    balanceAfter: aieLineItemMoney.nullable(),
  })
  .strict();

export type BankStatementTransactionFacts = z.infer<typeof bankStatementTransactionSchema>;

export const bankStatementDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION),
    documentMissingReasonCode: aieMissingReasonSchema,
    institutionName: aieTextField(200),
    /** Whatever partial account identifier the statement prints. The masking
     * layer will already have tokenised anything long enough to identify an
     * account, so in practice this arrives as a masked token or a genuine
     * last-4 — which is exactly the only form FDH-3 stores anyway
     * (`maskedAccountIdentifier` is re-checked and dropped downstream if it
     * still contains a long digit run). */
    maskedAccountIdentifier: aieTextField(64),
    statementPeriodStart: aieDateField(),
    statementPeriodEnd: aieDateField(),
    declaredOpeningBalance: aieMoneyField(),
    declaredClosingBalance: aieMoneyField(),
    /** The model's own statement about completeness. Recorded and shown to the
     * user, and used to force a review — but never trusted as the only check;
     * see `AIE_BANK_STATEMENT_MAX_TRANSACTIONS`. */
    allTransactionsListed: z.boolean(),
    transactions: z.array(bankStatementTransactionSchema).max(AIE_BANK_STATEMENT_MAX_TRANSACTIONS),
  })
  .strict();

export type BankStatementDocumentFacts = z.infer<typeof bankStatementDocumentFactsSchema>;

let registered = false;

/** Idempotent — safe to call from multiple module-load sites and tests, the
 * same convention as every other adapter's `register*Schema()`. */
export function registerBankStatementDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
    version: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
    schema: bankStatementDocumentFactsSchema,
    ownerAdapterId: 'aie_bank_statement_ai_fallback_v1',
  });
  registered = true;
}
