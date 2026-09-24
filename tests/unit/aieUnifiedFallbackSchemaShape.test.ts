/**
 * AIE unified document fallback — schema REGISTRATION and DRIFT checks for
 * the four new adapters.
 *
 * WHY THIS TEST EXISTS AT ALL — the registration half.
 *
 * `lib/aie/provider/openaiJsonSchema.ts`'s `KNOWN_SCHEMAS` map is a closed
 * map from `schemaName@version` to the strict JSON Schema actually sent to
 * OpenAI. It is NOT derived from the Zod schema: a schema missing from it
 * throws, the gateway maps that throw to `outcome: 'provider_error'`, and
 * every real provider call for that adapter therefore fails before returning
 * anything usable — while looking, from the outside, exactly like a transient
 * provider fault.
 *
 * That is not hypothetical. It is precisely what happened to Investment
 * Intelligence's own live AI-fallback mechanism (design document §6.1): its
 * whole-document schema was never added, so in any environment where
 * `AIE_AI_PROVIDER=openai` was actually set, every real II AI-fallback
 * attempt failed. It was caught only by a live provider call, months later.
 *
 * Four new adapters means four new chances to make the same mistake, and it
 * is a mistake that costs nothing to make and is invisible until real money
 * is being spent. So the check is mechanical: every schema this programme
 * registers must resolve, and the list below must stay in step with the
 * adapters that exist.
 *
 * AND THE DRIFT HALF. The Zod schema and the hand-written JSON Schema mirror
 * are kept in sync BY HAND, because this codebase deliberately has no
 * zod-to-json-schema converter. No mechanical check can prove two hand-written
 * schemas are equivalent — a matching-shaped-but-wrong pair would fool any of
 * them. What this does instead is validate one REPRESENTATIVE payload against
 * BOTH sides: the Zod schema must accept it, and it must satisfy the JSON
 * Schema's `required`/`additionalProperties`/`enum` constraints. That catches
 * the realistic drift (a field added to one side only), which is the failure
 * that actually happens, without pretending to be a proof of equivalence.
 */

import { describe, it, expect } from 'vitest';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';

import {
  bankStatementDocumentFactsSchema,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/bankStatement/schema';
import { BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/bankStatement/openaiSchema';
import {
  retirementDocumentFactsSchema,
  AIE_RETIREMENT_FACTS_SCHEMA_NAME,
  AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/retirement/schema';
import { RETIREMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/retirement/openaiSchema';
import {
  liabilityStatementDocumentFactsSchema,
  AIE_LIABILITY_FACTS_SCHEMA_NAME,
  AIE_LIABILITY_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/liability/schema';
import { LIABILITY_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/liability/openaiSchema';
import {
  auInvestmentDocumentFactsSchema,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/auInvestment/schema';
import { AU_INVESTMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/auInvestment/openaiSchema';

/** A scalar field envelope with a value supplied. */
const withValue = (v: string) => ({ value: v, missingReasonCode: null });
/** A scalar field envelope reporting that the document did not carry it. */
const absent = { value: null, missingReasonCode: 'not_present_on_document' as const };

const BANK_PAYLOAD = {
  schemaVersion: '1',
  documentMissingReasonCode: null,
  institutionName: withValue('Synthetic Test Bank'),
  maskedAccountIdentifier: withValue('1234'),
  statementPeriodStart: withValue('2026-03-01'),
  statementPeriodEnd: withValue('2026-03-31'),
  declaredOpeningBalance: withValue('1500.00'),
  declaredClosingBalance: absent,
  allTransactionsListed: true,
  transactions: [
    { transactionDate: '2026-03-02', descriptionRaw: 'COLES SUPERMARKET', amount: '82.40', creditDebit: 'debit', balanceAfter: '1417.60' },
    { transactionDate: '2026-03-05', descriptionRaw: 'SALARY', amount: '3200.00', creditDebit: 'credit', balanceAfter: null },
  ],
};

const RETIREMENT_PAYLOAD = {
  schemaVersion: '1',
  documentMissingReasonCode: null,
  fundName: withValue('Synthetic Test Super'),
  maskedAccountIdentifier: withValue('1993'),
  statementDate: withValue('2026-06-30'),
  statementStartDate: withValue('2025-07-01'),
  statementEndDate: withValue('2026-06-30'),
  openingBalance: withValue('45200.00'),
  closingBalance: withValue('54320.00'),
  employerContributions: withValue('6400.00'),
  personalContributions: withValue('1200.00'),
  salarySacrifice: absent,
  governmentContributions: absent,
  rolloversIn: absent,
  rolloversOut: absent,
  withdrawals: absent,
  pensionPayments: absent,
  investmentEarnings: withValue('3100.00'),
  fees: withValue('240.00'),
  insurancePremiums: withValue('380.00'),
  tax: withValue('960.00'),
  activities: [
    {
      activityType: 'EMPLOYER_CONTRIBUTION',
      amount: '533.33',
      activityDate: '2026-01-15',
      descriptionRaw: 'SG contribution',
      employerNameRaw: 'Synthetic Employer Pty Ltd',
      isSummaryTotal: false,
      isYearToDate: false,
    },
  ],
  positions: [
    { optionNameRaw: 'Balanced', assetClassRaw: 'Diversified', units: '1234.5678', unitPrice: '2.15', marketValue: '2654.32', valuationDate: '2026-06-30' },
  ],
};

/**
 * A deliberately small structural validator. It checks the three strict-mode
 * rules this codebase's hand-written schemas actually rely on — every
 * `required` key present, no key outside `properties`
 * (`additionalProperties: false`), and `enum` membership — plus array
 * `maxItems`. It is not a JSON Schema implementation and does not pretend to
 * be; adding one as a dependency for this would be the same unreviewed
 * dependency `openaiJsonSchema.ts` itself argues against.
 */
function validateAgainstJsonSchema(schema: Record<string, unknown>, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  // AIE-1 final completion (2026-09-25): money fields are an `anyOf` of two
  // exact shapes (see `aieMoneyFieldJsonSchema`). A value is valid when it
  // satisfies at least one branch -- the same rule OpenAI strict mode applies.
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = (schema.anyOf as Record<string, unknown>[]).map((b) => validateAgainstJsonSchema(b, value, path));
    return branchErrors.some((e) => e.length === 0) ? [] : [`${path}: matches no anyOf branch (${branchErrors.map((e) => e[0]).join(' | ')})`];
  }
  const type = schema.type;

  const typeAdmits = (t: string) => (Array.isArray(type) ? (type as string[]).includes(t) : type === t);

  if (value === null) {
    if (!typeAdmits('null')) errors.push(`${path}: null not permitted (type ${JSON.stringify(type)})`);
    return errors;
  }

  if (typeAdmits('object') && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in obj)) errors.push(`${path}.${key}: required by JSON Schema but absent from the payload`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}.${key}: present in the payload but not in the JSON Schema's properties`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validateAgainstJsonSchema(sub, obj[key], `${path}.${key}`));
    }
    return errors;
  }

  if (typeAdmits('array') && Array.isArray(value)) {
    const maxItems = schema.maxItems as number | undefined;
    if (typeof maxItems === 'number' && value.length > maxItems) errors.push(`${path}: ${value.length} items exceeds maxItems ${maxItems}`);
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, i) => errors.push(...validateAgainstJsonSchema(items, v, `${path}[${i}]`)));
    return errors;
  }

  if (typeAdmits('string') && typeof value === 'string') {
    const en = schema.enum as unknown[] | undefined;
    if (en && !en.includes(value)) errors.push(`${path}: "${value}" is not in the schema's enum`);
    return errors;
  }

  if (typeAdmits('boolean') && typeof value === 'boolean') return errors;
  if (typeAdmits('number') && typeof value === 'number') return errors;

  errors.push(`${path}: value of type ${Array.isArray(value) ? 'array' : typeof value} does not match schema type ${JSON.stringify(type)}`);
  return errors;
}

const LIABILITY_PAYLOAD = {
  schemaVersion: '1',
  documentMissingReasonCode: null,
  institutionName: withValue('Synthetic Test Lender'),
  maskedIdentifier: withValue('7777'),
  statementPeriodStart: withValue('2026-03-01'),
  statementPeriodEnd: withValue('2026-03-31'),
  statementDate: withValue('2026-03-31'),
  dueDate: absent,
  openingBalance: withValue('412000.00'),
  closingBalance: withValue('411020.00'),
  creditLimit: absent,
  minimumPayment: absent,
  interestRate: withValue('6.49'),
  allActivitiesListed: true,
  activities: [
    {
      activityType: 'PRINCIPAL',
      activityDate: '2026-03-05',
      amount: '2450.00',
      descriptionRaw: 'Repayment',
      merchantRaw: null,
      principalComponent: '980.00',
      interestComponent: '1470.00',
      feeComponent: null,
    },
  ],
};

const AU_INVESTMENT_PAYLOAD = {
  schemaVersion: '1',
  documentMissingReasonCode: null,
  institutionName: withValue('Synthetic Test Broker'),
  statementDate: withValue('2026-03-31'),
  statementPeriodStart: withValue('2026-03-01'),
  statementPeriodEnd: withValue('2026-03-31'),
  allRowsListed: true,
  holdings: [
    {
      securityNameRaw: 'Sample Holdings Ltd',
      tickerRaw: 'AAA',
      isin: null,
      quantity: '1000',
      // Deliberately more than 2 decimal places: AU unit prices are routinely
      // printed to 3-6, which is exactly why this field uses the wider
      // quantity decimal rather than the 2dp money one. A payload the real
      // world produces, asserted to be accepted.
      unitPrice: '12.50432',
      marketValue: '12504.32',
      valuationDate: '2026-03-31',
    },
  ],
  transactions: [
    {
      transactionType: 'BUY',
      tradeDate: '2026-03-10',
      settlementDate: '2026-03-12',
      securityNameRaw: 'Sample Holdings Ltd',
      tickerRaw: 'AAA',
      quantity: '100',
      unitPrice: '12.40',
      amount: '1240.00',
      brokerage: '9.50',
    },
  ],
};

const ADAPTERS = [
  {
    label: 'bank statement',
    name: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
    version: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
    zod: bankStatementDocumentFactsSchema,
    json: BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA,
    payload: BANK_PAYLOAD,
  },
  {
    label: 'retirement statement',
    name: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
    version: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
    zod: retirementDocumentFactsSchema,
    json: RETIREMENT_FACTS_OPENAI_JSON_SCHEMA,
    payload: RETIREMENT_PAYLOAD,
  },
  {
    label: 'liability statement',
    name: AIE_LIABILITY_FACTS_SCHEMA_NAME,
    version: AIE_LIABILITY_FACTS_SCHEMA_VERSION,
    zod: liabilityStatementDocumentFactsSchema,
    json: LIABILITY_FACTS_OPENAI_JSON_SCHEMA,
    payload: LIABILITY_PAYLOAD,
  },
  {
    label: 'AU investment statement',
    name: AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
    version: AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
    zod: auInvestmentDocumentFactsSchema,
    json: AU_INVESTMENT_FACTS_OPENAI_JSON_SCHEMA,
    payload: AU_INVESTMENT_PAYLOAD,
  },
] as const;

/** All four adapters this dispatch adds must be present above. A fifth
 * adapter added later without an entry here would otherwise ship with no
 * registration check at all — which is the exact way §6.1's defect reached
 * production. */
const EXPECTED_ADAPTER_COUNT = 4;

describe('AIE unified fallback — OpenAI strict-schema registration', () => {
  it('covers all four adapters this dispatch adds', () => {
    expect(ADAPTERS).toHaveLength(EXPECTED_ADAPTER_COUNT);
  });

  it.each(ADAPTERS)('$label resolves through getKnownOpenAiJsonSchema (the step §6.1 records as already forgotten once)', ({ name, version }) => {
    expect(() => getKnownOpenAiJsonSchema(name, version)).not.toThrow();
    const resolved = getKnownOpenAiJsonSchema(name, version);
    expect(resolved).toBeTruthy();
    expect(resolved.type).toBe('object');
    // Strict mode requires this on every object, and OpenAI rejects the
    // request outright without it — a provider-side 400, not a silent
    // mis-shape.
    expect(resolved.additionalProperties).toBe(false);
  });

  it('an unregistered schema still throws loudly rather than guessing a shape', () => {
    expect(() => getKnownOpenAiJsonSchema('aie_not_a_real_schema', '1')).toThrow(/no strict JSON Schema mapping registered/);
  });
});

describe('AIE unified fallback — Zod / JSON Schema drift detector', () => {
  it.each(ADAPTERS)('$label: a representative payload satisfies BOTH schemas', ({ zod, json, payload }) => {
    const zodResult = zod.safeParse(payload);
    expect(zodResult.success, zodResult.success ? '' : JSON.stringify(zodResult.error.issues, null, 2)).toBe(true);

    const jsonErrors = validateAgainstJsonSchema(json, payload);
    expect(jsonErrors, jsonErrors.join('\n')).toEqual([]);
  });

  it.each(ADAPTERS)('$label: the JSON Schema lists EVERY property as required (strict-mode rule)', ({ json }) => {
    const props = Object.keys((json.properties ?? {}) as Record<string, unknown>);
    const required = ((json.required ?? []) as string[]).slice().sort();
    expect(required).toEqual(props.slice().sort());
  });

  it.each(ADAPTERS)('$label: the two schemas agree on the top-level property SET', ({ zod, json }) => {
    // The realistic drift is a field added to one side and not the other.
    // Comparing the key sets catches exactly that.
    const jsonKeys = Object.keys((json.properties ?? {}) as Record<string, unknown>).sort();
    const zodKeys = Object.keys((zod as unknown as { shape: Record<string, unknown> }).shape).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });
});

describe('AIE unified fallback — the schemas refuse what they are meant to refuse', () => {
  it('bank statement: a money value as a JSON number is rejected, not coerced', () => {
    const bad = { ...BANK_PAYLOAD, transactions: [{ ...BANK_PAYLOAD.transactions[0], amount: 82.4 as unknown as string }] };
    expect(bankStatementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it("bank statement: the document's own printed money format is rejected", () => {
    // The exact failure observed live against gpt-4o-mini before the shared
    // format instructions were added to the prompt.
    const bad = { ...BANK_PAYLOAD, transactions: [{ ...BANK_PAYLOAD.transactions[0], amount: '$3,200.00' }] };
    expect(bankStatementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it('bank statement: a non-ISO date is rejected', () => {
    const bad = { ...BANK_PAYLOAD, transactions: [{ ...BANK_PAYLOAD.transactions[0], transactionDate: '01/03/2026' }] };
    expect(bankStatementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it('bank statement: an unknown extra field is rejected (.strict everywhere)', () => {
    const bad = { ...BANK_PAYLOAD, reconciliationStatus: 'reconciled' };
    expect(bankStatementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it('retirement: a value AND a missingReasonCode together is rejected on a money field', () => {
    const bad = { ...RETIREMENT_PAYLOAD, closingBalance: { value: '100.00', missingReasonCode: 'illegible' } };
    expect(retirementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it('retirement: a null value with NO missingReasonCode is rejected on a money field', () => {
    // "I don't know" must always have a typed shape — a bare null would let
    // the model decline to answer without saying anything about the document.
    const bad = { ...RETIREMENT_PAYLOAD, closingBalance: { value: null, missingReasonCode: null } };
    expect(retirementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });

  it('retirement: an activity type outside the closed vocabulary is rejected', () => {
    const bad = { ...RETIREMENT_PAYLOAD, activities: [{ ...RETIREMENT_PAYLOAD.activities[0], activityType: 'SOMETHING_INVENTED' }] };
    expect(retirementDocumentFactsSchema.safeParse(bad).success).toBe(false);
  });
});
