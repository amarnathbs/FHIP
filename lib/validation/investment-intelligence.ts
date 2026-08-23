import { z } from 'zod';

// Zod validation for the R1 Investment Intelligence API surface. Kept
// intentionally narrow — R1 does not expose unrestricted generic CRUD over
// ii_* tables (spec section 30).

export const iiAccountSchema = z.object({
  accountType: z.enum(['demat', 'mf_folio', 'broker', 'retirement', 'bank_linked', 'other']),
  institutionName: z.string().min(1),
  countryCode: z.enum(['AU', 'IN']),
  currencyCode: z.enum(['AUD', 'INR']),
  folioNumber: z.string().optional().nullable(),
  accountNumberMasked: z.string().optional().nullable(),
  ownerMemberId: z.string().uuid().optional().nullable(),
});

export const iiGoalAllocationSchema = z.object({
  goalId: z.string().uuid(),
  investmentPositionId: z.string().uuid(),
  allocationType: z.enum(['percentage', 'fixed_amount', 'residual']),
  allocationValue: z.number().min(0).nullable(),
  linkedInvestmentId: z.string().uuid().optional().nullable(), // only present once the position is actually published
});

export const iiSourceDocumentUploadMetaSchema = z.object({
  sourceKey: z.string().min(1),
  documentType: z.enum(['cas_statement', 'demat_statement', 'contract_note', 'manual_entry_record', 'other']).default('other'),
  countryCode: z.enum(['AU', 'IN']),
  ownerMemberId: z.string().uuid().optional().nullable(),
  statementPeriodStart: z.string().optional().nullable(),
  statementPeriodEnd: z.string().optional().nullable(),
  statementAsOfDate: z.string().optional().nullable(),
});

// The deterministic manual/test importer fixture shape
// (R1_IMPLEMENTATION_SPEC.md sections 8 and 12) — developer/QA-only, never
// a production CAS parser input.
export const iiIdentifierCandidateSchema = z.object({
  scheme: z.enum(['isin', 'amfi_scheme_code', 'nse_symbol', 'bse_code', 'sedol', 'internal_provisional']),
  value: z.string().min(1),
  countryCode: z.enum(['AU', 'IN']).optional().nullable(),
});

export const iiFixtureTransactionSchema = z.object({
  transactionType: z.enum([
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
  ]),
  transactionDate: z.string(),
  units: z.number().optional().nullable(),
  pricePerUnit: z.number().optional().nullable(),
  grossAmount: z.number(),
  sourceReference: z.string().optional().nullable(),
});

export const iiManualFixtureSchema = z.object({
  fixtureKey: z.string().min(1),
  sourceKey: z.string().min(1),
  countryCode: z.enum(['AU', 'IN']),
  currencyCode: z.enum(['AUD', 'INR']),
  documentType: z.enum(['cas_statement', 'demat_statement', 'contract_note', 'manual_entry_record', 'other']).default('manual_entry_record'),
  originalFilename: z.string().min(1),
  account: z.object({
    accountType: z.enum(['demat', 'mf_folio', 'broker', 'retirement', 'bank_linked', 'other']),
    institutionName: z.string().min(1),
    folioNumber: z.string().optional().nullable(),
    accountNumberMasked: z.string().optional().nullable(),
  }),
  instrument: z.object({
    instrumentName: z.string().min(1),
    instrumentClass: z.enum(['equity', 'mutual_fund', 'etf', 'bond', 'fixed_deposit', 'gold', 'crypto', 'cash', 'other']),
    countryOfDomicile: z.enum(['AU', 'IN']),
    baseCurrency: z.enum(['AUD', 'INR']),
    identifiers: z.array(iiIdentifierCandidateSchema).default([]),
  }),
  transactions: z.array(iiFixtureTransactionSchema).default([]),
  holdingSnapshot: z.object({
    asOfDate: z.string(),
    units: z.number(),
    value: z.number(),
    qualityStatus: z.enum(['certified', 'warning', 'incomplete']).default('warning'),
  }),
  supersedesFixtureKey: z.string().optional().nullable(),
  reconciliation: z
    .object({
      discrepancyType: z.string(),
      discrepancyDetails: z.record(z.unknown()).optional(),
    })
    .optional()
    .nullable(),
});

export type IiManualFixture = z.infer<typeof iiManualFixtureSchema>;
