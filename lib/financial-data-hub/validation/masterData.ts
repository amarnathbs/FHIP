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
  FDH_GOVERNANCE_STATUSES,
  FDH_MERCHANT_ALIAS_SOURCES,
  FDH_MERCHANT_ALIAS_TYPES,
  FDH_MERCHANT_TYPES,
  FDH_PARSER_VERSION_STATUSES,
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
  tax_reporting_flag: z.boolean().default(false),
  // Forward-looking metadata for the FDH-15 bridge. Populating it creates no
  // integration: nothing in FDH reads it and nothing writes Input Data.
  fhip_mapping_key: z.string().max(120).nullish(),
  display_order: z.number().int().min(0).default(0),
  icon_key: z.string().max(60).nullish(),
  active: z.boolean().default(true),
  version: z.number().int().min(1).default(1),
});

export const fdhSubcategorySchema = z.object({
  category_id: fdhUuid,
  subcategory_key: fdhMachineKey,
  display_name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  country_applicability: fdhCountryApplicability.default(['AU', 'IN']),
  essential_discretionary: z.enum(FDH_ESSENTIAL_DISCRETIONARY).nullish(),
  fhip_mapping_key: z.string().max(120).nullish(),
  display_order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  version: z.number().int().min(1).default(1),
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
