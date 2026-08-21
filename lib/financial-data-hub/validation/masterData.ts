/**
 * Financial Data Hub — validation for category, subcategory, merchant, alias
 * and parser master data.
 *
 * Every schema here guards an ADMIN / SERVICE-ROLE write path. None of these
 * tables has an INSERT or UPDATE policy for the authenticated role, so an
 * ordinary user session cannot write them regardless of what application code
 * does. FDH-1 exposes no route that uses these; they exist so FDH-2 and FDH-13
 * have a validated contract rather than inventing one.
 */

import { z } from 'zod';
import {
  FDH_DOCUMENT_TYPES,
  FDH_ECONOMIC_TRANSACTION_TYPES,
  FDH_ESSENTIAL_DISCRETIONARY,
  FDH_FIXED_VARIABLE,
  FDH_GLOBAL_LEARNING_CANDIDATE_TYPES,
  FDH_GLOBAL_LEARNING_STATUSES,
  FDH_GOVERNANCE_STATUSES,
  FDH_INSTITUTION_CAPABILITY_TYPES,
  FDH_INSTITUTION_COVERAGE_STATUSES,
  FDH_MCC_BROAD_GROUPS,
  FDH_MCC_CONFIDENCE_STATES,
  FDH_MCC_MAPPING_CONFIDENCE,
  FDH_MCC_MAPPING_TYPES,
  FDH_MERCHANT_ALIAS_SOURCES,
  FDH_MERCHANT_ALIAS_TYPES,
  FDH_MERCHANT_TYPES,
  FDH_PARSER_VERSION_STATUSES,
  FDH_PAYMENT_RAIL_CATEGORIES,
  FDH_PII_SCREENING_STATUSES,
  FDH_RECURRING_TYPES,
  FDH_SOURCE_TYPES,
} from '../constants/enums';
import {
  fdhCountryApplicability,
  fdhCountryCode,
  fdhMachineKey,
  fdhMcc,
  fdhTimestamp,
  fdhUnitInterval,
  fdhUuid,
} from './primitives';

export const fdhCategorySchema = z.object({
  // A STABLE MACHINE KEY, never a display label. Renaming a display name must
  // never silently repoint every historical transaction.
  category_key: fdhMachineKey,
  display_name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  economic_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES),
  country_applicability: fdhCountryApplicability.default(['AU', 'IN']),
  essential_discretionary: z.enum(FDH_ESSENTIAL_DISCRETIONARY).nullish(),
  // FDH-2 additions — metadata only, never classification logic.
  fixed_variable: z.enum(FDH_FIXED_VARIABLE).nullish(),
  retirement_relevance: z.boolean().default(false),
  investment_relevance: z.boolean().default(false),
  debt_relevance: z.boolean().default(false),
  source_key: fdhMachineKey.nullish(),
  effective_from: z.string().date().nullish(),
  deprecated_at: fdhTimestamp.nullish(),
  replacement_key: fdhMachineKey.nullish(),
  tax_reporting_flag: z.boolean().default(false),
  // Forward-looking metadata for the FDH-15 bridge. Populating it creates no
  // integration: nothing in FDH reads it and nothing writes Input Data.
  fhip_mapping_key: z.string().max(120).nullish(),
  display_order: z.number().int().min(0).default(0),
  icon_key: z.string().max(60).nullish(),
  active: z.boolean().default(true),
  version: z.number().int().min(1).default(1),
}).superRefine((v, ctx) => {
  if (v.deprecated_at && v.active) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['active'], message: 'a deprecated category must not be active' });
  }
  if (v.replacement_key && !v.deprecated_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replacement_key'], message: 'a replacement_key requires deprecated_at to be set' });
  }
  if (v.replacement_key && v.replacement_key === v.category_key) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replacement_key'], message: 'a category cannot replace itself' });
  }
});

export const fdhSubcategorySchema = z.object({
  category_id: fdhUuid,
  subcategory_key: fdhMachineKey,
  display_name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  country_applicability: fdhCountryApplicability.default(['AU', 'IN']),
  essential_discretionary: z.enum(FDH_ESSENTIAL_DISCRETIONARY).nullish(),
  fixed_variable: z.enum(FDH_FIXED_VARIABLE).nullish(),
  retirement_relevance: z.boolean().default(false),
  investment_relevance: z.boolean().default(false),
  debt_relevance: z.boolean().default(false),
  source_key: fdhMachineKey.nullish(),
  effective_from: z.string().date().nullish(),
  deprecated_at: fdhTimestamp.nullish(),
  replacement_subcategory_id: fdhUuid.nullish(),
  fhip_mapping_key: z.string().max(120).nullish(),
  display_order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  version: z.number().int().min(1).default(1),
}).superRefine((v, ctx) => {
  if (v.deprecated_at && v.active) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['active'], message: 'a deprecated subcategory must not be active' });
  }
  if (v.replacement_subcategory_id && !v.deprecated_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replacement_subcategory_id'], message: 'a replacement requires deprecated_at to be set' });
  }
});

/**
 * FDH-2 ADDITION — an MCC master row. An MCC is an INPUT SIGNAL, never an
 * absolute classification (specification section 21-23).
 */
export const fdhMccSchema = z.object({
  mcc: fdhMcc,
  official_or_public_description: z.string().min(1).max(300),
  normalized_description: z.string().min(1).max(200),
  broad_group: z.enum(FDH_MCC_BROAD_GROUPS),
  active: z.boolean().default(true),
  source_key: fdhMachineKey.nullish(),
  source_version: z.string().max(60).nullish(),
  country_relevance: fdhCountryApplicability.default(['AU', 'IN']),
  notes: z.string().max(500).nullish(),
});

/**
 * FDH-2 ADDITION — one MCC-to-category mapping. Deliberately allows
 * category_id/subcategory_id to be null when the MCC is genuinely ambiguous
 * — see the `superRefine` rules, which mirror the database's own check
 * constraints so an invalid combination is rejected before it ever reaches
 * SQL.
 */
export const fdhMccCategoryMapSchema = z.object({
  mcc: fdhMcc,
  country_code: fdhCountryCode.nullish(),
  category_id: fdhUuid.nullish(),
  subcategory_id: fdhUuid.nullish(),
  mapping_confidence: z.enum(FDH_MCC_MAPPING_CONFIDENCE),
  mapping_type: z.enum(FDH_MCC_MAPPING_TYPES),
  ambiguity_flag: z.boolean().default(false),
  requires_additional_context: z.boolean().default(false),
  notes: z.string().max(500).nullish(),
}).superRefine((v, ctx) => {
  if (v.subcategory_id && !v.category_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subcategory_id'], message: 'a subcategory mapping requires its parent category' });
  }
  if (v.ambiguity_flag && v.subcategory_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subcategory_id'], message: 'an ambiguous mapping must not carry a subcategory' });
  }
  if (v.mapping_type === 'ambiguous_unmapped' && v.category_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['category_id'], message: 'an ambiguous_unmapped mapping must not carry a category' });
  }
});

/**
 * FDH-2 ADDITION — institution-master extension fields (coverage_status
 * etc). This is the fields FDH-2 ADDS to fdh_financial_institutions; the
 * base identity fields (country_code/institution_code/institution_name/
 * institution_type) are unchanged from FDH-1.
 */
export const fdhInstitutionExtensionSchema = z.object({
  coverage_status: z.enum(FDH_INSTITUTION_COVERAGE_STATUSES).default('master_only'),
  legal_name: z.string().max(300).nullish(),
  parent_group: z.string().max(200).nullish(),
  website_domain: z.string().max(200).nullish(),
  source_key: fdhMachineKey.nullish(),
  source_checked_at: z.string().date().nullish(),
});

export const fdhInstitutionCapabilitySchema = z.object({
  institution_id: fdhUuid,
  capability_type: z.enum(FDH_INSTITUTION_CAPABILITY_TYPES),
});

export const fdhInstitutionAliasSchema = z.object({
  institution_id: fdhUuid,
  alias: z.string().min(1).max(200),
  alias_normalized: z.string().min(1).max(200),
  source: z.enum(['admin_curated', 'imported_dataset', 'external_reference']),
  confidence: fdhUnitInterval.nullish(),
  verified: z.boolean().default(false),
  active: z.boolean().default(true),
});

/** FDH-2 ADDITION — a payment MECHANISM, never an economic category. */
export const fdhPaymentRailSchema = z.object({
  rail_key: fdhMachineKey,
  display_name: z.string().min(1).max(120),
  country_code: fdhCountryCode.nullish(),
  rail_category: z.enum(FDH_PAYMENT_RAIL_CATEGORIES),
  description: z.string().max(500).nullish(),
  active: z.boolean().default(true),
});

/**
 * A canonical merchant.
 *
 * `verification_status` is the governance lifecycle. A new merchant proposed
 * from observed data starts at `proposed` and only an administrator can move
 * it to `approved` — a user correction NEVER becomes a global merchant record.
 */
export const fdhMerchantSchema = z
  .object({
    canonical_name: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200),
    country_code: fdhCountryCode.nullish(),
    merchant_type: z.enum(FDH_MERCHANT_TYPES).nullish(),
    default_category_id: fdhUuid.nullish(),
    default_subcategory_id: fdhUuid.nullish(),
    mcc: fdhMcc.nullish(),
    // FDH-2 additions.
    mcc_confidence: z.enum(FDH_MCC_CONFIDENCE_STATES).nullish(),
    website_domain: z.string().max(200).nullish(),
    parent_company_name: z.string().max(200).nullish(),
    recurring_possible: z.boolean().default(false),
    typical_frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annual', 'irregular']).nullish(),
    fixed_amount_expected: z.boolean().default(false),
    variable_amount_possible: z.boolean().default(true),
    recurring_type: z.enum(FDH_RECURRING_TYPES).nullish(),
    is_payment_processor: z.boolean().default(false),
    source_key: fdhMachineKey.nullish(),
    source_checked_at: z.string().date().nullish(),
    subscription_possible: z.boolean().default(false),
    essential_discretionary: z.enum(FDH_ESSENTIAL_DISCRETIONARY).nullish(),
    verification_status: z.enum(FDH_GOVERNANCE_STATUSES).default('proposed'),
    merged_into_merchant_id: fdhUuid.nullish(),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.verification_status === 'merged' && !v.merged_into_merchant_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['merged_into_merchant_id'],
        message: 'a merged merchant must name its surviving record',
      });
    }
    if (v.mcc_confidence && !v.mcc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mcc_confidence'],
        message: 'mcc_confidence requires mcc to be set',
      });
    }
  });

/**
 * FDH-2 ADDITION — the global-learning governance candidate. See
 * lib/financial-data-hub/domain/globalLearningGovernance.ts for the
 * transition rules this schema's `status`/`pii_screening_status` combination
 * must satisfy, enforced a second time here via `superRefine` (mirroring the
 * database's `chk_fdh_glc_pii_gate` constraint).
 */
export const fdhGlobalLearningCandidateSchema = z
  .object({
    candidate_type: z.enum(FDH_GLOBAL_LEARNING_CANDIDATE_TYPES),
    country_code: fdhCountryCode.nullish(),
    merchant_id: fdhUuid.nullish(),
    proposed_alias_normalized: z.string().max(200).nullish(),
    current_category_id: fdhUuid.nullish(),
    proposed_category_id: fdhUuid.nullish(),
    proposed_subcategory_id: fdhUuid.nullish(),
    number_of_independent_users: z.number().int().min(0).default(0),
    number_of_corrections: z.number().int().min(0).default(0),
    number_of_matching_aliases: z.number().int().min(0).default(0),
    confidence: fdhUnitInterval.nullish(),
    pii_screening_status: z.enum(FDH_PII_SCREENING_STATUSES).default('not_screened'),
    pii_screening_notes: z.string().max(500).nullish(),
    status: z.enum(FDH_GLOBAL_LEARNING_STATUSES).default('open'),
  })
  .superRefine((v, ctx) => {
    if ((v.status === 'approved' || v.status === 'merged') && v.pii_screening_status !== 'passed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pii_screening_status'],
        message: `${v.status} requires pii_screening_status to be "passed"`,
      });
    }
  });

export const fdhMerchantAliasSchema = z.object({
  merchant_id: fdhUuid,
  country_code: fdhCountryCode.nullish(),
  alias_normalised: z.string().min(1).max(200),
  alias_type: z.enum(FDH_MERCHANT_ALIAS_TYPES),
  source: z.enum(FDH_MERCHANT_ALIAS_SOURCES),
  confidence: fdhUnitInterval.nullish(),
  verified: z.boolean().default(false),
});

export const fdhParserRegistrySchema = z.object({
  parser_key: fdhMachineKey,
  // Nullable: a generic CSV parser belongs to no single institution.
  institution_id: fdhUuid.nullish(),
  document_type: z.enum(FDH_DOCUMENT_TYPES),
  source_format: z.enum(FDH_SOURCE_TYPES),
  country_code: fdhCountryCode.nullish(),
  active: z.boolean().default(true),
});

/**
 * A parser version.
 *
 * The governing principle is that institution support is not one successful
 * document: a version is `development` until it has been certified against a
 * real fixture set, and every processed statement records which version read
 * it so a later layout change can be attributed and reprocessed.
 */
export const fdhParserVersionSchema = z
  .object({
    parser_id: fdhUuid,
    version: z.string().min(1).max(40),
    status: z.enum(FDH_PARSER_VERSION_STATUSES).default('development'),
    introduced_at: fdhTimestamp.nullish(),
    retired_at: fdhTimestamp.nullish(),
    supported_layout_reference: z.string().max(200).nullish(),
    notes: z.string().max(1000).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.introduced_at && v.retired_at && v.retired_at < v.introduced_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retired_at'],
        message: 'retired_at must not be earlier than introduced_at',
      });
    }
    if (v.status === 'certified' && !v.introduced_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['introduced_at'],
        message: 'a certified parser version must record when it entered service',
      });
    }
  });

export type FdhCategoryInput = z.infer<typeof fdhCategorySchema>;
export type FdhSubcategoryInput = z.infer<typeof fdhSubcategorySchema>;
export type FdhMerchantInput = z.infer<typeof fdhMerchantSchema>;
export type FdhMerchantAliasInput = z.infer<typeof fdhMerchantAliasSchema>;
export type FdhParserRegistryInput = z.infer<typeof fdhParserRegistrySchema>;
export type FdhParserVersionInput = z.infer<typeof fdhParserVersionSchema>;
export type FdhMccInput = z.infer<typeof fdhMccSchema>;
export type FdhMccCategoryMapInput = z.infer<typeof fdhMccCategoryMapSchema>;
export type FdhInstitutionExtensionInput = z.infer<typeof fdhInstitutionExtensionSchema>;
export type FdhInstitutionCapabilityInput = z.infer<typeof fdhInstitutionCapabilitySchema>;
export type FdhInstitutionAliasInput = z.infer<typeof fdhInstitutionAliasSchema>;
export type FdhPaymentRailInput = z.infer<typeof fdhPaymentRailSchema>;
export type FdhGlobalLearningCandidateInput = z.infer<typeof fdhGlobalLearningCandidateSchema>;
