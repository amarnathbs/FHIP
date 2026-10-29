/**
 * The REAL governed reference data (FDH-2 category / subcategory / merchant / rule seeds under data/financial-data-hub), loaded as the
 * classification engine receives it from the database: category_key -> id resolved, every merchant approved and active, every alias verified.
 * Synthetic ids only. Used by the coverage tests so they exercise the engine against exactly the data production has.
 */
import { categories as catSeed } from '../../data/financial-data-hub/categories.mjs';
import { subcategories as subSeed } from '../../data/financial-data-hub/subcategories.mjs';
import { merchantsAu } from '../../data/financial-data-hub/merchantsAu.mjs';
import { merchantsIn } from '../../data/financial-data-hub/merchantsIn.mjs';
import { classificationRules } from '../../data/financial-data-hub/classificationRules.mjs';
import type { ClassifiableTransaction, ClassificationReferenceData } from '@/lib/financial-data-hub/classification/types';
import type { OwnIdentity } from '@/lib/financial-data-hub/classification/ownIdentity';

/* eslint-disable @typescript-eslint/no-explicit-any -- seed files are untyped .mjs */
export function buildReferenceFromSeeds(opts: { ownIdentity?: OwnIdentity; country?: 'AU' | 'IN' } = {}): ClassificationReferenceData {
  const country = opts.country ?? 'AU';
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const categories = (catSeed as any[]).map((c) => ({ ...c, id: id('cat'), active: true }));
  const catByKey = new Map(categories.map((c) => [c.category_key, c]));
  const subcategories = (subSeed as any[]).map((s) => ({ ...s, id: id('sub'), category_id: catByKey.get(s.category_key)!.id, active: true }));
  const subByKey = new Map(subcategories.map((s) => [`${s.category_key}.${s.subcategory_key}`, s]));
  const merchants: any[] = [];
  const merchantAliases: any[] = [];
  for (const m of (country === 'AU' ? merchantsAu : merchantsIn) as any[]) {
    const mid = id('mer');
    merchants.push({
      id: mid, canonical_name: m.canonical_name, display_name: m.display_name,
      default_category_id: m.category_key ? catByKey.get(m.category_key)?.id ?? null : null,
      default_subcategory_id: m.category_key && m.subcategory_key ? subByKey.get(`${m.category_key}.${m.subcategory_key}`)?.id ?? null : null,
      subscription_possible: m.subscription_possible, verification_status: 'approved', active: m.active ?? true,
    });
    for (const a of m.aliases ?? []) merchantAliases.push({ id: id('ali'), merchant_id: mid, alias_normalised: a, verified: true });
  }
  const globalRules = (classificationRules as any[])
    .filter((r) => r.country_applicability.includes(country))
    .map((r) => {
      const a = { ...r.action_definition };
      if (a.action_kind === 'classify') {
        if (a.category_key) a.category_id = catByKey.get(a.category_key)?.id;
        if (a.category_key && a.subcategory_key) a.subcategory_id = subByKey.get(`${a.category_key}.${a.subcategory_key}`)?.id;
        delete a.category_key;
        delete a.subcategory_key;
      }
      return { ...r, id: id('rul'), action_definition: a, active: true, status: 'approved' };
    });
  return { categories, subcategories, merchants, merchantAliases, globalRules, userRules: [], ownIdentity: opts.ownIdentity } as unknown as ClassificationReferenceData;
}

export function txnOf(description: string, over: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    id: 't1', financial_account_id: 'acct', transaction_date: '2026-01-01', description_clean: description, merchant_raw: null,
    amount_original: 50, currency_original: 'AUD', credit_debit: 'debit', transaction_type_hint: 'debit', user_override: false, ...over,
  };
}
