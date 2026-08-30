/**
 * FDH-12 — SMSF detection and routing (spec sections 10-11).
 *
 * ============================================================================
 * THE NON-NEGOTIABLE BOUNDARY
 * ============================================================================
 *
 * FHIP already owns Self-Managed Super Funds: migrations 0084 (schema, AU
 * gate), 0089 (summary mode) and 0090 (balance integrity guard), the
 * `smsf_funds`/`smsf_fund_members`/`smsf_holdings` tables, the three
 * `smsf_*` RPCs, and the SMSF section of the Retirement page. FDH-12 must not
 * duplicate any of it, and must never import an SMSF statement as ordinary
 * super (spec section 10).
 *
 * BEFORE FDH-12 THERE WAS NO SMSF DETECTION ANYWHERE IN THE REPOSITORY. A
 * repo-wide search for `self.managed`, `self managed` and `trustee` across
 * every `.ts`/`.tsx`/`.sql` file returns three hits, none of them a
 * classifier: UI copy in `components/retirement/smsf/SmsfSection.tsx`, an
 * editorial placeholder in `lib/resources/money-update/blocks.ts`, and a
 * comment in migration 0051. SMSF was identified solely by exact equality on
 * `master_item_key = 'smsf'`. This module is therefore a genuinely NEW
 * FDH-12 evidence capability, and it is deliberately scoped to *routing* — it
 * classifies and hands off. It contains no SMSF business logic, creates no
 * SMSF row, and patches nothing inside the SMSF module (spec section 173).
 *
 * ============================================================================
 * NEVER SILENTLY CLASSIFY SMSF AS ORDINARY SUPER (spec section 11)
 * ============================================================================
 *
 * Three outcomes, and the middle one is the important one:
 *
 *   'routed_to_smsf'  — confident. Terminal for FDH-12: the statement can
 *                       never be approved (migration 0111 PART H refuses) and
 *                       so can never become a proposal.
 *   'possible_smsf'   — ambiguous. ALSO blocks approval, pending the user's
 *                       explicit confirmation. Ambiguity resolves to REVIEW,
 *                       never to "probably ordinary super".
 *   'not_smsf'        — no SMSF evidence at all.
 *
 * There is deliberately no "confidence score above which we proceed anyway".
 */

export type SmsfClassification = 'not_smsf' | 'possible_smsf' | 'routed_to_smsf';

export interface SmsfDetectionEvidence {
  /** The matched phrase, lower-cased, as it appeared. */
  term: string;
  /** Which field it was found in. */
  field: 'fund_name' | 'statement_text';
  /** 'strong' on its own justifies routing; 'weak' only raises REVIEW. */
  weight: 'strong' | 'weak';
}

export interface SmsfDetectionResult {
  classification: SmsfClassification;
  evidence: SmsfDetectionEvidence[];
  /** Human-facing reason, shown in the review UI. */
  reason: string;
}

/**
 * STRONG markers — an unambiguous statement of self-management. Any one of
 * these in the fund name, or two anywhere, routes to SMSF.
 *
 * Every term here is a phrase that a retail/industry super fund's member
 * statement has no reason to contain. "Trustee" alone is NOT here, and that
 * omission is load-bearing: every super fund has a trustee (an APRA-regulated
 * one), so "trustee" appears on ordinary member statements constantly. It is a
 * weak marker only.
 */
const STRONG_SMSF_TERMS = [
  'self-managed super fund',
  'self managed super fund',
  'self-managed superannuation fund',
  'self managed superannuation fund',
  'smsf',
  'self-managed super',
  'self managed super',
] as const;

/**
 * WEAK markers — consistent with an SMSF but also with an ordinary fund, or
 * with a document that merely mentions SMSFs. Two weak markers raise REVIEW;
 * they never route on their own.
 */
const WEAK_SMSF_TERMS = [
  'trustee declaration',
  'corporate trustee',
  'individual trustee',
  'trust deed',
  'fund tax return',
  'member balance report',
  'annual return for the fund',
  'auditor contravention',
  'atf ',              // "as trustee for" — common in SMSF entity names
  'as trustee for',
  'superannuation fund trust',
] as const;

function normalise(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Classify a retirement statement as SMSF or not.
 *
 * @param fundName          the fund/institution name as extracted
 * @param statementText     any additional statement text available (headings,
 *                          document title, first-page text). Optional: a CSV
 *                          upload may have nothing beyond the fund name, and
 *                          that is a valid input, not a failure.
 */
export function detectSmsf(
  fundName: string | null | undefined,
  statementText?: string | null,
): SmsfDetectionResult {
  const name = normalise(fundName);
  const text = normalise(statementText);

  /**
   * Collect matches, then DISCARD any term that is merely a substring of
   * another matched term.
   *
   * Without this, the single phrase "self-managed super fund" matches THREE
   * entries of `STRONG_SMSF_TERMS` at once — `'self-managed super fund'`,
   * `'self-managed super'` and (via the hyphen-insensitive spelling) more
   * besides — so one mention would score as several and the
   * `strongCount >= 2` rule below would route it. That was a real defect: a
   * sentence like "You may transfer to a self-managed super fund at any time"
   * on an ORDINARY fund's statement would have been routed away as an SMSF
   * rather than raised for review. Counting distinct PHRASES, not distinct
   * dictionary entries, is what makes `strongCount` mean what the rules below
   * assume it means.
   */
  const collect = (
    terms: readonly string[],
    weight: 'strong' | 'weak',
  ): SmsfDetectionEvidence[] => {
    const hits: { term: string; field: 'fund_name' | 'statement_text' }[] = [];
    for (const term of terms) {
      if (name.includes(term)) hits.push({ term, field: 'fund_name' });
      else if (text.includes(term)) hits.push({ term, field: 'statement_text' });
    }
    return hits
      .filter((h) => !hits.some((other) => other.term !== h.term && other.term.includes(h.term)))
      .map((h) => ({ ...h, weight }));
  };

  const evidence: SmsfDetectionEvidence[] = [
    ...collect(STRONG_SMSF_TERMS, 'strong'),
    ...collect(WEAK_SMSF_TERMS, 'weak'),
  ];

  const strongInName = evidence.some((e) => e.weight === 'strong' && e.field === 'fund_name');
  const strongCount = evidence.filter((e) => e.weight === 'strong').length;
  const weakCount = evidence.filter((e) => e.weight === 'weak').length;

  // A strong marker in the FUND NAME is decisive: a fund does not accidentally
  // call itself an SMSF.
  if (strongInName) {
    return {
      classification: 'routed_to_smsf',
      evidence,
      reason: 'The fund name identifies this as a self-managed super fund.',
    };
  }
  // A strong marker in body text alone is suggestive but not decisive — an
  // ordinary fund's statement could mention SMSFs in a disclosure paragraph.
  // Two of them is decisive.
  if (strongCount >= 2) {
    return {
      classification: 'routed_to_smsf',
      evidence,
      reason: 'This statement repeatedly identifies itself as a self-managed super fund.',
    };
  }
  if (strongCount === 1) {
    return {
      classification: 'possible_smsf',
      evidence,
      reason: 'This statement mentions a self-managed super fund. Confirm whether it is one before importing.',
    };
  }
  if (weakCount >= 2) {
    return {
      classification: 'possible_smsf',
      evidence,
      reason: 'This statement contains wording often used by self-managed super funds. Confirm before importing.',
    };
  }

  return { classification: 'not_smsf', evidence, reason: 'No self-managed super fund indicators found.' };
}

/**
 * Whether an FDH-12 statement in this classification may proceed to approval
 * and therefore to a proposal.
 *
 * The DB enforces this independently (migration 0111 PART H refuses to approve
 * anything other than `not_smsf`). This function exists so the UI can explain
 * the block rather than merely reporting it.
 */
export function smsfClassificationAllowsImport(c: SmsfClassification): boolean {
  return c === 'not_smsf';
}
