/**
 * R8 — Merchant normalisation (spec sections 37-39).
 *
 * "Verified merchant alias" is precedence tier 3 (`classificationPrecedence
 * .ts`) — the direct fdh_merchants/fdh_merchant_aliases master-data lookup,
 * NOT a `fdh_classification_rules` row (FDH-2 seeded zero `merchant_exact`/
 * `merchant_alias` global rules; the merchant master's own `default_
 * category_id`/`default_subcategory_id` IS the "COSTCO -> Groceries"
 * mapping the spec's worked example describes).
 *
 * A merchant only ever matches by a VERIFIED alias (`verified: true`) or an
 * approved canonical name (`verification_status: 'approved'`) — an
 * unverified alias is deliberately never matched here. Tier 7 ("fuzzy
 * merchant match") is documented across FDH-2/R7 as NOT IMPLEMENTED
 * anywhere in this codebase; this module does not implement it either,
 * matching that disclosed boundary rather than quietly inventing a fuzzy
 * matcher under a different name.
 */

import type { FdhMerchant, FdhMerchantAlias } from '../domain/types';
import { toMatchText } from './textMatch';

export interface MerchantMatch {
  merchant: FdhMerchant;
  matchedOn: 'canonical_name' | 'alias';
  matchedText: string;
}

/**
 * Finds the best merchant match for a transaction's normalised description
 * (and raw merchant string, when the source provided one). Longer matched
 * text wins ties — "WOOLWORTHS METRO" over "WOOLWORTHS" — so a more specific
 * alias is never shadowed by a shorter, more general one.
 */
export function matchMerchant(
  descriptionClean: string | null,
  merchantRaw: string | null,
  merchants: FdhMerchant[],
  aliases: FdhMerchantAlias[],
): MerchantMatch | null {
  const haystack = toMatchText([descriptionClean, merchantRaw].filter(Boolean).join(' '));
  if (haystack.length === 0) return null;

  let best: MerchantMatch | null = null;
  const consider = (candidate: MerchantMatch) => {
    if (!best || candidate.matchedText.length > best.matchedText.length) best = candidate;
  };

  const merchantById = new Map(merchants.map((m) => [m.id, m]));

  for (const alias of aliases) {
    if (!alias.verified) continue;
    const term = toMatchText(alias.alias_normalised);
    if (term.length === 0 || !haystack.includes(term)) continue;
    const merchant = merchantById.get(alias.merchant_id);
    if (!merchant || !merchant.active || merchant.verification_status !== 'approved') continue;
    consider({ merchant, matchedOn: 'alias', matchedText: term });
  }

  for (const merchant of merchants) {
    if (!merchant.active || merchant.verification_status !== 'approved') continue;
    const term = toMatchText(merchant.canonical_name);
    if (term.length === 0 || !haystack.includes(term)) continue;
    consider({ merchant, matchedOn: 'canonical_name', matchedText: term });
  }

  return best;
}
