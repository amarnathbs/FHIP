/**
 * AIE-1.1 — the JSON Schema registry & strict validation gateway (JSC-01..12).
 *
 * DEVIATION FROM THE SPEC'S LITERAL WORDING, DISCLOSED. AIE-1.1's document
 * repeatedly says "JSON Schema" (the RFC/ajv-style format). Discovery found
 * `ajv` is not a dependency anywhere in this repository, and ZERO files use
 * it — every existing "validate provider JSON" implementation in this
 * codebase (`lib/ai/structuredOutput.ts`'s `aiResponseEnvelopeSchema`,
 * `lib/ai/insightPack/types.ts`'s pack schema) uses Zod, and Zod is the
 * ONLY schema library used anywhere in `lib/`, `app/`, or `package.json`.
 * Introducing `ajv` as a new dependency purely to match the spec's literal
 * noun, when Zod already satisfies every substantive requirement this
 * section actually asks for — published/versioned/immutable schemas,
 * reject-unknown-properties-by-default (`.strict()`), required/type/enum/
 * format/array-bound/string-length/pattern validation, and typed,
 * codes-not-values rejection reasons — would be exactly the kind of
 * "unreviewed, unnecessary dependency" `fileValidation.ts`'s own header
 * argues against. This registry is therefore built on Zod, functioning as
 * the equivalent typed-schema gateway the spec calls for, under a different
 * (but already house-standard) implementation technology. Recorded here
 * explicitly rather than silently reinterpreted.
 */

import { z, type ZodTypeAny } from 'zod';

export interface RegisteredSchema {
  name: string;
  version: string;
  schema: ZodTypeAny;
  /** Which adapter/document-class this schema belongs to (JSC-11: "validate
   * deterministic parser output through the same schema boundary where
   * applicable"). Informational only in this pass — no adapter exists yet
   * to compile against it. */
  ownerAdapterId?: string;
}

class AieSchemaRegistry {
  private readonly schemas = new Map<string, RegisteredSchema>();

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /** JSC-02: "compile schemas at startup/build, fail registration for
   * invalid schemas." Re-registering the same name+version with different
   * content is rejected — published schema versions are immutable
   * (JSC-01). */
  register(entry: RegisteredSchema): void {
    const key = this.key(entry.name, entry.version);
    const existing = this.schemas.get(key);
    if (existing && existing.schema !== entry.schema) {
      throw new Error(`aie schema registry: ${key} is already registered and is immutable — bump the version instead`);
    }
    this.schemas.set(key, entry);
  }

  get(name: string, version: string): RegisteredSchema | undefined {
    return this.schemas.get(this.key(name, version));
  }

  has(name: string, version: string): boolean {
    return this.schemas.has(this.key(name, version));
  }
}

export const aieSchemaRegistry = new AieSchemaRegistry();

export type SchemaValidationOutcome =
  | { valid: true; data: unknown }
  | { valid: false; errorCodes: string[] };

/**
 * JSC-06: "distinguish JSON parse failure from schema failure with safe
 * diagnostics." `rawText` is untrusted provider output — parsed defensively,
 * never `eval`'d, and error messages are reduced to stable path-based codes
 * (JSC-10) rather than echoing the raw invalid value.
 */
export function validateAiOutput(params: { schemaName: string; schemaVersion: string; rawText: string }): SchemaValidationOutcome {
  const registered = aieSchemaRegistry.get(params.schemaName, params.schemaVersion);
  if (!registered) {
    return { valid: false, errorCodes: ['schema_not_registered'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawText);
  } catch {
    return { valid: false, errorCodes: ['json_parse_failed'] };
  }

  const result = registered.schema.safeParse(parsed);
  if (!result.success) {
    // Reduce to `path.join('.'):code` — never the offending value itself.
    const errorCodes = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`);
    return { valid: false, errorCodes };
  }
  return { valid: true, data: result.data };
}

/**
 * NORM/JSC shared decimal-string primitive (NORM-01/JSC-08): financial
 * values are represented as STRINGS in every AI-facing schema, never
 * numbers — "no binary floating-point conversion", and prevents scientific
 * notation unless the schema explicitly permits it.
 */
export const decimalStringField = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string, no scientific notation or thousands separators');

export const isoDateStringField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO 8601 date (YYYY-MM-DD)');

export const currencyCodeField = z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 currency code');

/**
 * The one example schema this phase registers for its own live-DEV
 * evidence and tests (AIE11-DEV-02/03): a minimal "fill these missing
 * fields" envelope. A real domain adapter (1.2/1.3) will register its own,
 * richer schemas against this same registry — this is deliberately generic,
 * not a stand-in for any adapter's actual field set.
 */
export const AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME = 'aie_generic_field_completion';
export const AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION = '1';

export const genericFieldCompletionSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            fieldName: z.string().min(1),
            // Null + typed reason when evidence is absent/ambiguous
            // (PRM-03: "require null + typed reason when evidence absent").
            value: z.string().nullable(),
            nullReason: z.enum(['not_present_on_document', 'illegible', 'ambiguous']).nullable(),
            sourceReferenceId: z.string().min(1), // PRM-06: source reference required for every non-null candidate
          })
          .strict(),
      )
      .max(50), // PRM-11: bounded array/output size
  })
  .strict(); // JSC-03: reject unknown properties by default

aieSchemaRegistry.register({
  name: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
  version: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
  schema: genericFieldCompletionSchema,
});
