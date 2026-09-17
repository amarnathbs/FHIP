/**
 * M12B section 6 — THE REAL AI PRIVACY PROOF HARNESS.
 *
 * DOMAIN-AGNOSTIC, LIKE `aieAccuracyHarness.ts`, AND FOR THE SAME REASON: the
 * privacy question is identical for FDH-bank and for Insurance, and the two
 * must not be able to answer it to different standards. Nothing in this file
 * knows what a bank statement or a policy schedule is. It takes the bytes that
 * would leave the process, a list of the literal identifiers the source
 * document actually contained, a list of the financial evidence that must
 * SURVIVE, and it returns a verdict per category.
 *
 * WHERE THE MEASUREMENT IS TAKEN, AND WHY IT IS THERE.
 * Not on `maskText`'s return value, and not on the gateway's arguments. On the
 * REAL `OpenAiAieProvider`'s own outbound HTTP request body — the last
 * artefact that exists before the process hands bytes to the network. Anything
 * measured earlier proves a property of an intermediate value; this proves a
 * property of what egresses. It is also the only vantage point from which the
 * `store: false` flag and the strict-JSON-schema declaration are observable,
 * because the provider adds both itself, after every other layer is done.
 *
 * WHAT "PRE-EGRESS" MEANS HERE, PRECISELY. The harness is fed the serialised
 * request body captured from an intercepted `fetch`. The interception replaces
 * the network, so the bytes are built by entirely real code and then examined
 * instead of sent. That is a STRONGER proof than a live call, not a weaker one:
 * a live call proves one payload was acceptable, whereas the captured body can
 * be asserted against every forbidden literal exhaustively, including the ones
 * a live call would have transmitted before anyone could look.
 *
 * THE TWO-SIDED TEST. A masking layer can pass a "no PII" assertion by
 * destroying the document. So every proof carries BOTH lists: identifiers that
 * must be absent, and financial evidence that must be present. H.9's own
 * wording is the standard — "financial values needed for extraction may
 * remain" — and a harness that only checked absence would happily certify a
 * layer that sent an empty string.
 */

export type AiePrivacyCategory =
  | 'person_name'
  | 'tax_id'
  | 'aadhaar'
  | 'email'
  | 'phone'
  | 'address'
  | 'bank_account'
  | 'ifsc'
  | 'account_identifier';

/** Every category the M12 dispatch names, in its own order, so a future reader
 * can check the list against the dispatch without interpretation. */
export const REQUIRED_PRIVACY_CATEGORIES: AiePrivacyCategory[] = [
  'person_name',
  'tax_id',
  'aadhaar',
  'email',
  'phone',
  'address',
  'bank_account',
  'ifsc',
  'account_identifier',
];

export interface ForbiddenLiteral {
  category: AiePrivacyCategory;
  /** Human label for the report — never the value itself when reported. */
  label: string;
  /** The exact string as it appears on the source document. */
  literal: string;
}

export interface RequiredEvidenceLiteral {
  label: string;
  literal: string;
}

/** One captured outbound payload. `rawRequestBody` is the serialised HTTP body
 * exactly as the provider built it. */
export interface CapturedEgress {
  url: string;
  rawRequestBody: string;
  /** Parsed, for the structural assertions. Null when the body is not JSON. */
  parsedBody: Record<string, unknown> | null;
}

export interface PrivacyProofInput {
  adapter: string;
  caseId: string;
  /** Every payload captured for this case. An empty array is NOT a pass — see
   * `egressOccurred`. */
  captured: CapturedEgress[];
  forbidden: ForbiddenLiteral[];
  requiredEvidence: RequiredEvidenceLiteral[];
}

export interface CategoryVerdict {
  category: AiePrivacyCategory;
  /** How many literals of this category the source document contained. */
  literalsChecked: number;
  /** Labels of the literals that LEAKED. Empty is the only passing value. */
  leaked: string[];
  /** 'not_applicable' when the source document contained no literal of this
   * category, and 'not_proven' when no payload was built at all — NEITHER is
   * ever reported as a pass, because in neither case was anything proved. */
  verdict: 'pass' | 'fail' | 'not_applicable' | 'not_proven';
}

export interface PrivacyProofResult {
  adapter: string;
  caseId: string;
  egressOccurred: boolean;
  payloadCount: number;
  categories: CategoryVerdict[];
  /** Labels of required financial evidence that did NOT survive masking. */
  evidenceDestroyed: string[];
  evidenceChecked: number;
  /** Every payload declared a strict JSON schema. */
  strictJsonSchemaDeclared: boolean;
  /** Every payload explicitly opted out of provider-side storage. */
  storeDisabled: boolean;
  /** At least one masking placeholder is present, i.e. the payload is
   * demonstrably the output of the masking layer rather than raw text that
   * happened to contain no recognised pattern. */
  maskingPlaceholderPresent: boolean;
  /**
   * The overall verdict. `vacuous` is deliberately a THIRD value rather than a
   * pass: a case where no payload was ever built cannot leak, and reporting
   * that as a pass is precisely the vacuous-zero trap M12A recorded twice. A
   * vacuous result means the privacy question was not answered for this case,
   * and the reason has to be explained rather than counted as evidence.
   */
  verdict: 'pass' | 'fail' | 'vacuous';
  failures: string[];
}

const MASK_PLACEHOLDER = '[MASKED:';

export function proveEgressPrivacy(input: PrivacyProofInput): PrivacyProofResult {
  const failures: string[] = [];
  const egressOccurred = input.captured.length > 0;

  const haystacks = input.captured.map((c) => c.rawRequestBody);
  const appearsAnywhere = (literal: string) => haystacks.some((h) => h.includes(literal));

  const categories: CategoryVerdict[] = REQUIRED_PRIVACY_CATEGORIES.map((category) => {
    const literals = input.forbidden.filter((f) => f.category === category);
    if (literals.length === 0) {
      return { category, literalsChecked: 0, leaked: [], verdict: 'not_applicable' as const };
    }
    // No payload was built, so nothing about egress was demonstrated for this
    // category. NOT a pass — see `PrivacyProofResult.verdict`.
    if (!egressOccurred) {
      return { category, literalsChecked: literals.length, leaked: [], verdict: 'not_proven' as const };
    }
    const leaked = literals.filter((l) => appearsAnywhere(l.literal)).map((l) => l.label);
    return { category, literalsChecked: literals.length, leaked, verdict: leaked.length === 0 ? ('pass' as const) : ('fail' as const) };
  });

  for (const c of categories) {
    if (c.verdict === 'fail') failures.push(`${c.category}: leaked ${c.leaked.join(', ')}`);
  }

  const evidenceDestroyed = egressOccurred ? input.requiredEvidence.filter((e) => !appearsAnywhere(e.literal)).map((e) => e.label) : [];
  if (evidenceDestroyed.length > 0) failures.push(`financial evidence destroyed by masking: ${evidenceDestroyed.join(', ')}`);

  const strictJsonSchemaDeclared =
    egressOccurred &&
    input.captured.every((c) => {
      const rf = c.parsedBody?.response_format as { type?: string; json_schema?: { strict?: boolean; schema?: unknown } } | undefined;
      return rf?.type === 'json_schema' && rf.json_schema?.strict === true && rf.json_schema?.schema !== undefined;
    });
  if (egressOccurred && !strictJsonSchemaDeclared) failures.push('at least one payload did not declare a strict JSON schema');

  const storeDisabled = egressOccurred && input.captured.every((c) => c.parsedBody?.store === false);
  if (egressOccurred && !storeDisabled) failures.push('at least one payload did not explicitly disable provider-side storage');

  const maskingPlaceholderPresent = haystacks.some((h) => h.includes(MASK_PLACEHOLDER));

  return {
    adapter: input.adapter,
    caseId: input.caseId,
    egressOccurred,
    payloadCount: input.captured.length,
    categories,
    evidenceDestroyed,
    evidenceChecked: input.requiredEvidence.length,
    strictJsonSchemaDeclared,
    storeDisabled,
    maskingPlaceholderPresent,
    verdict: !egressOccurred ? 'vacuous' : failures.length === 0 ? 'pass' : 'fail',
    failures,
  };
}

export function formatPrivacyTable(results: PrivacyProofResult[]): string {
  const header =
    '| Adapter | Case | Egress | person name | tax id | aadhaar | email | phone | address | bank acct | IFSC | acct id | evidence survived | strict schema | store:false | verdict |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const cell = (v: CategoryVerdict | undefined) =>
    v === undefined ? '—' : v.verdict === 'pass' ? 'PASS' : v.verdict === 'fail' ? '**LEAK**' : v.verdict === 'not_proven' ? '**not proven**' : 'n/a';
  const rows = results.map((r) => {
    const by = new Map(r.categories.map((c) => [c.category, c]));
    return (
      `| ${r.adapter} | ${r.caseId} | ${r.payloadCount} | ` +
      REQUIRED_PRIVACY_CATEGORIES.map((c) => cell(by.get(c))).join(' | ') +
      ` | ${!r.egressOccurred || r.evidenceChecked === 0 ? 'n/a' : r.evidenceDestroyed.length === 0 ? `${r.evidenceChecked}/${r.evidenceChecked}` : `**${r.evidenceChecked - r.evidenceDestroyed.length}/${r.evidenceChecked}**`} | ` +
      `${r.strictJsonSchemaDeclared ? 'yes' : 'n/a'} | ${r.storeDisabled ? 'yes' : 'n/a'} | ` +
      `${r.verdict === 'pass' ? 'PASS' : r.verdict === 'vacuous' ? '**VACUOUS**' : '**FAIL**'} |`
    );
  });
  return [header, ...rows].join('\n');
}
