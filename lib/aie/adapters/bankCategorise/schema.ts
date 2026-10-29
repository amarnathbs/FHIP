/**
 * AIE bank-line categorisation -- the versioned answer contract.
 *
 * WHAT THE MODEL IS ASKED FOR, AND WHY IT IS SO LITTLE. For each payee string it is shown (already masked, digits removed, business-style
 * narratives only -- person-to-person lines are never sent), ONE category key from a closed list and how sure it is. Nothing else: no amount, no
 * date, no account, no name, no free text back. The answer is a PROPOSAL; the deterministic code (bankCategoriseProposals.ts) re-checks every key
 * against the list the caller offered and turns anything else, and anything not 'high'/'medium', into "unknown".
 */
import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';

export const AIE_BANK_CATEGORISE_SCHEMA_NAME = 'aie_bank_categorise_payees';
export const AIE_BANK_CATEGORISE_SCHEMA_VERSION = '1';
/** Distinct payee strings per provider call. */
export const AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL = 40;
export const AIE_BANK_CATEGORISE_CONFIDENCE = ['high', 'medium', 'low'] as const;

export const bankCategoriseAnswerSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            /** The key the caller gave the payee (p1, p2, ...). */
            key: z.string().regex(/^p\d{1,3}$/),
            /** A category key from the offered list, or the literal "unknown". Checked against the list in code. */
            categoryKey: z.string().min(1).max(60),
            confidence: z.enum(AIE_BANK_CATEGORISE_CONFIDENCE),
          })
          .strict(),
      )
      .max(AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL),
  })
  .strict();
export type BankCategoriseAnswer = z.infer<typeof bankCategoriseAnswerSchema>;

let registered = false;
/** Idempotent -- safe to call from multiple sites and tests. */
export function registerBankCategoriseSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_BANK_CATEGORISE_SCHEMA_NAME,
    version: AIE_BANK_CATEGORISE_SCHEMA_VERSION,
    schema: bankCategoriseAnswerSchema,
    ownerAdapterId: 'aie_bank_categorise_ai_v1',
  });
  registered = true;
}
