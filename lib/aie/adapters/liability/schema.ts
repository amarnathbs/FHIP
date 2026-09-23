/**
 * AIE liability-statement AI-fallback adapter — versioned whole-document
 * facts contract for a credit-card or loan statement.
 *
 * WHAT THE MODEL IS ASKED FOR, AND WHY IT IS SO LITTLE. Exactly the facts a
 * human reads off the page: the statement header (institution, the masked
 * card/account identifier the statement itself prints, the period, the
 * statement and due dates, the opening and closing balance, and — where the
 * document prints them — the credit limit, minimum payment and interest
 * rate), plus each activity line's type, date, positive amount, printed
 * description, and any principal/interest/fee split the statement itself
 * discloses. That is all.
 *
 * Everything else an `fdh_liability_statements` row needs — the per-type
 * totals (purchases, cash advances, interest, fees, payments, refunds,
 * drawdowns, principal repaid), the reconciliation verdict and its variance,
 * the bank-payment matching of every PAYMENT line, the review status — is
 * DERIVED by the existing, already-certified deterministic code
 * (`reconcileCreditCardStatement`, `reconcileLoanStatement`,
 * `matchBankPayment`, and the totals arithmetic inside
 * `persistLiabilityStatementEvidence`) from those raw readings. The AI is used
 * as a reader for a CSV layout the deterministic adapter registry could not
 * map, not as a second implementation of FDH-10's pipeline. This is the single
 * most important property of this adapter: an AI-read statement faces the
 * identical reconciliation arithmetic and the identical bank-matching pass as
 * a natively-parsed one, so it cannot bypass the checks that make a native
 * import trustworthy.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each absence is a rule rather than an
 * omission:
 *   - NO `currencyCode`, NO `countryCode`, NO `statementType`. Jurisdiction,
 *     currency and "is this a card or a loan" are CALLER CONTEXT, chosen by
 *     the user in the upload form before the AI was ever asked, and are never
 *     AI-derived anywhere in this codebase.
 *   - NO `facilityType` (home_loan / personal_loan / line_of_credit / ...).
 *     This one is worth stating loudly, because it is the field FDH-10's own
 *     live-DEV certification round found capable of silently creating a
 *     DUPLICATE mortgage when it was wrong (see
 *     `persistLiabilityStatementEvidence`'s own `facilityType` comment). A
 *     wrong facility type does not merely mislabel a row, it makes
 *     `facilityMatching.ts` unable to find the user's existing liability at
 *     all. It is therefore NOT a fact this adapter will accept from a model:
 *     on the AI path the user picks it explicitly at the confirm step.
 *   - NO confidence field anywhere (P4/REC-04). A model's self-reported
 *     certainty is not evidence, and having one invites it to be used as if
 *     it were.
 *   - NO canonical id of any kind — no `liability_id`, no `statement_id`, no
 *     `financial_account_id`. Nothing the AI returns may name an existing row.
 */

import { z } from 'zod';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import {
  aieDateField,
  aieMoneyField,
  aieQuantityField,
  aieTextField,
  aieMissingReasonSchema,
  aieLineItemMoney,
  aieLineItemDate,
} from '../shared/factsFields';

export const AIE_LIABILITY_FACTS_SCHEMA_NAME = 'aie_liability_statement_document_facts';
export const AIE_LIABILITY_FACTS_SCHEMA_VERSION = '1';

/**
 * Hard cap on activity rows in one extraction.
 *
 * Sized against the line-item output budget
 * (`getAieAiMaxOutputTokensPerLineItemDocument()`), not chosen aesthetically —
 * a liability activity row is a little richer than a bank transaction row
 * (three optional component amounts), so this is deliberately set at the same
 * conservative 80 the bank adapter uses rather than higher.
 *
 * A statement with MORE rows than this does not fail silently. The model is
 * asked to state explicitly whether it listed every row
 * (`allActivitiesListed`), and — far more reliably, because it does not depend
 * on the model being honest or correct — the extracted totals are re-run
 * through the same `reconcileCreditCardStatement`/`reconcileLoanStatement`
 * arithmetic the native path uses, where missing rows make the statement fail
 * to add up and land as `reconciliation_status = 'variance'` with
 * `review_status = 'pending'` instead of quietly reconciled.
 */
export const AIE_LIABILITY_MAX_ACTIVITIES = 80;

/**
 * One activity line as PRINTED. Deliberately flat and small: a per-field
 * `missingReasonCode` envelope on every row would multiply the token cost of
 * the whole document for no benefit, because a row the model could not read
 * should simply be omitted — and its omission is then caught by the
 * reconciliation arithmetic, which is a real check rather than a self-report.
 *
 * `activityType` reuses FDH-10's OWN `LIABILITY_ACTIVITY_TYPES` vocabulary
 * verbatim rather than declaring a parallel list. That is not just tidiness:
 * `fdh_liability_statement_activities.activity_type` carries a DB CHECK
 * constraint over exactly that vocabulary, so a hand-retyped enum that drifted
 * by one value would produce a constraint violation at write time — after the
 * user had already reviewed and confirmed the draft.
 */
export const liabilityStatementActivitySchema = z
  .object({
    activityType: z.enum(LIABILITY_ACTIVITY_TYPES),
    activityDate: aieLineItemDate,
    /** POSITIVE MAGNITUDE ONLY. Direction/meaning is carried by
     * `activityType` and derived downstream by `creditCardEconomics.ts` /
     * `repaymentDecomposition.ts` — exactly the convention
     * `LiabilityStatementActivity.amount` itself documents. A signed amount
     * here would be a second, contradictory encoding of direction. */
    amount: aieLineItemMoney,
    /** The description EXACTLY as printed, or null when the layout prints
     * none. FDH-10 stores this verbatim as purgeable evidence; no cleaning
     * happens on either the native or this path. */
    descriptionRaw: z.string().max(500).nullable(),
    merchantRaw: z.string().max(200).nullable(),
    /** The statement's OWN disclosed repayment split, where it prints one
     * (an EMI/home-loan statement commonly does). Null means "the statement
     * did not print this", never "the model could not be bothered" — and a
     * null simply leaves the component out of the interest/fees totals, the
     * same as a native extraction that found no split. These are never
     * derived by the model: it is asked only to copy a printed split. */
    principalComponent: aieLineItemMoney.nullable(),
    interestComponent: aieLineItemMoney.nullable(),
    feeComponent: aieLineItemMoney.nullable(),
  })
  .strict();

export type LiabilityStatementActivityFacts = z.infer<typeof liabilityStatementActivitySchema>;

export const liabilityStatementDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_LIABILITY_FACTS_SCHEMA_VERSION),
    documentMissingReasonCode: aieMissingReasonSchema,
    institutionName: aieTextField(200),
    /** Whatever partial card/account identifier the statement prints. The
     * masking layer will already have tokenised anything long enough to
     * identify an account, so in practice this arrives as a masked token or a
     * genuine last-4 — which is the only form FDH-10 stores anyway
     * (`chk_fdh_liability_statements_masked_identifier` is the DB-side
     * backstop, and the confirm route re-checks it before any write). */
    maskedIdentifier: aieTextField(40),
    statementPeriodStart: aieDateField(),
    statementPeriodEnd: aieDateField(),
    statementDate: aieDateField(),
    dueDate: aieDateField(),
    /** Opening/closing balance for a card; opening/closing principal for a
     * loan. ONE pair, not two: which column of
     * `fdh_liability_statements` they land in is decided by the caller's own
     * `statementType`, never by the model — see
     * `persistLiabilityStatementEvidence`'s `isCreditCard` branch. */
    openingBalance: aieMoneyField(),
    closingBalance: aieMoneyField(),
    creditLimit: aieMoneyField(),
    minimumPayment: aieMoneyField(),
    /** A PERCENTAGE as printed (e.g. "6.49"), not a fraction, and not money —
     * hence the wider quantity field. FDH-10's own
     * `liabilityStatementUploadMetadataSchema` takes the same units from the
     * upload form, so the two paths agree without a conversion step that
     * could silently differ by a factor of 100. */
    interestRate: aieQuantityField(),
    /** The model's own statement about completeness. Recorded and shown to
     * the user in words, and used to force a review — but never trusted as
     * the only check; see `AIE_LIABILITY_MAX_ACTIVITIES`. */
    allActivitiesListed: z.boolean(),
    activities: z.array(liabilityStatementActivitySchema).max(AIE_LIABILITY_MAX_ACTIVITIES),
  })
  .strict();

export type LiabilityStatementDocumentFacts = z.infer<typeof liabilityStatementDocumentFactsSchema>;

let registered = false;

/** Idempotent — safe to call from multiple module-load sites and tests, the
 * same convention as every other adapter's `register*Schema()`. */
export function registerLiabilityStatementDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_LIABILITY_FACTS_SCHEMA_NAME,
    version: AIE_LIABILITY_FACTS_SCHEMA_VERSION,
    schema: liabilityStatementDocumentFactsSchema,
    ownerAdapterId: 'aie_liability_statement_ai_fallback_v1',
  });
  registered = true;
}
